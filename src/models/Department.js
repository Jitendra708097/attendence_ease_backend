module.exports = (sequelize, DataTypes) => {
  const Department = sequelize.define(
    'Department',
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
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      parent_id: DataTypes.UUID,
      head_emp_id: DataTypes.UUID,
    },
    {
      tableName: 'departments',
      paranoid: true,
      underscored: true,
    }
  );

  Department.associate = (models) => {
    Department.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Department.belongsTo(models.Department, {
      foreignKey: 'parent_id',
      as: 'parentDepartment',
    });
    Department.hasMany(models.Department, {
      foreignKey: 'parent_id',
      as: 'subDepartments',
    });
    Department.belongsTo(models.Employee, {
      foreignKey: 'head_emp_id',
      as: 'headEmployee',
    });
  };

  return Department;
};
