module.exports = (sequelize, DataTypes) => {
  const Employee = sequelize.define(
    'Employee',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branch_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      department_id: DataTypes.UUID,
      shift_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_code: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      email: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      phone: DataTypes.STRING,
      password_hash: DataTypes.STRING,
      role: {
        type: DataTypes.ENUM('admin', 'manager', 'employee', 'superadmin'),
        defaultValue: 'employee',
      },
      face_embedding_local: {
        type: DataTypes.JSONB,
        defaultValue: null,
      },
      face_embedding_id: DataTypes.STRING,
      face_enrolled_at: DataTypes.DATE,
      registered_device_id: DataTypes.STRING,
      trust_score: {
        type: DataTypes.ENUM('probationary', 'default', 'trusted', 'flagged'),
        defaultValue: 'probationary',
      },
      checkin_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      leave_balance: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      temp_password: DataTypes.STRING,
      password_changed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: 'employees',
      paranoid: true,
      underscored: true,
    }
  );

  Employee.associate = (models) => {
    Employee.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Employee.belongsTo(models.Branch, {
      foreignKey: 'branch_id',
      as: 'branch',
    });
    Employee.belongsTo(models.Department, {
      foreignKey: 'department_id',
      as: 'department',
    });
    Employee.belongsTo(models.Shift, {
      foreignKey: 'shift_id',
      as: 'shift',
    });
    Employee.hasMany(models.RefreshToken, {
      foreignKey: 'emp_id',
      as: 'refreshTokens',
    });
    Employee.hasMany(models.Attendance, {
      foreignKey: 'emp_id',
      as: 'attendances',
    });
  };

  return Employee;
};
