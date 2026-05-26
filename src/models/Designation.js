module.exports = (sequelize, DataTypes) => {
  const Designation = sequelize.define(
    'Designation',
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
      code: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
    },
    {
      tableName: 'designations',
      paranoid: true,
      underscored: true,
    }
  );

  Designation.associate = (models) => {
    Designation.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Designation.hasMany(models.Employee, {
      foreignKey: 'designation_id',
      as: 'employees',
    });
  };

  return Designation;
};
